import { render, screen } from '@testing-library/react';
import App from './App';

test('renders the application heading', () => {
  render(<App />);
  expect(screen.getByRole('heading', { name: /tuva terminology viewer/i })).toBeInTheDocument();
});
